/** Crash-contained child-process supervisor for the Usage Ledger reducer. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { encodeWorkerFrame } from "./worker-protocol.js";
const RESTART_MIN_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 5000;
const MAX_PENDING_SESSIONS = 1024;
function safeWorkerEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key === 'NODE_OPTIONS' || key.startsWith('DSH_'))
            continue;
        if (/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH)/i.test(key))
            continue;
        env[key] = value;
    }
    return env;
}
function defaultWorkerPath() {
    const url = import.meta.url.endsWith('.ts')
        ? new URL('../../lib/backfill-worker.js', import.meta.url)
        : new URL('./backfill-worker.js', import.meta.url);
    return fileURLToPath(url);
}
/**
 * Keep the main process responsive when the worker pipe is full. Live frames
 * are coalesced by session; the next provider-backed rescan repairs any
 * sequence gap after persistence catches up.
 */
export class UsageWorkerSupervisor {
    callbacks;
    workerPath;
    child;
    output;
    initFrame;
    blocked = false;
    stopping = false;
    restartTimer;
    restartDelay = RESTART_MIN_DELAY_MS;
    refreshInit;
    restarting = false;
    pendingLive = new Map();
    pendingControl = new Map();
    exitPromise;
    resolveExit;
    constructor(callbacks, workerPath = defaultWorkerPath()) {
        this.callbacks = callbacks;
        this.workerPath = workerPath;
    }
    /** Start or replace the child with a complete initialization snapshot. */
    start(frame, refreshInit) {
        this.initFrame = frame;
        this.refreshInit = refreshInit;
        this.stopping = false;
        this.spawnWorker();
    }
    /** Send one compact live event, merging it when stdin applies backpressure. */
    sendLive(frame) {
        if (this.child === undefined || this.stopping || this.blocked || this.pendingLive.size > 0) {
            this.pendingLive.set(frame.session.id, frame);
            this.trimPending(this.pendingLive);
            return;
        }
        this.write(frame);
    }
    /** Send a control frame, also coalesced per session while the pipe is full. */
    sendControl(frame, key) {
        if (this.child === undefined || this.stopping || this.blocked || this.pendingLive.size > 0) {
            this.pendingControl.set(key, frame);
            this.trimPending(this.pendingControl);
            return;
        }
        this.write(frame);
    }
    /** Stop without making plugin disposal wait for a wedged worker. */
    async stop() {
        this.stopping = true;
        if (this.restartTimer !== undefined)
            clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        const child = this.child;
        if (child === undefined)
            return;
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
            this.write({ type: 'stop' });
            child.stdin.end();
        }
        const exit = this.exitPromise ?? Promise.resolve();
        await Promise.race([
            exit,
            new Promise(resolve => setTimeout(resolve, 1000)),
        ]);
        if (this.child !== undefined && !this.child.killed)
            this.child.kill('SIGTERM');
        this.child = undefined;
        this.output?.close();
        this.output = undefined;
    }
    spawnWorker() {
        if (this.stopping || this.initFrame === undefined)
            return;
        if (this.restarting && this.refreshInit !== undefined) {
            try {
                this.initFrame = this.refreshInit();
            }
            catch (error) {
                this.failed(`usage ledger worker restart snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.restarting = false;
        const nodeArgs = [`--max-old-space-size=${String(this.initFrame.config.workerMaxHeapMiB ?? 512)}`, this.workerPath];
        const command = process.platform === 'win32' ? process.execPath : 'nice';
        const args = process.platform === 'win32'
            ? nodeArgs
            : ['-n', '10', process.execPath, ...nodeArgs];
        let child;
        try {
            child = spawn(command, args, {
                cwd: process.cwd(),
                env: safeWorkerEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (error) {
            this.failed(error);
            return;
        }
        this.child = child;
        this.blocked = false;
        this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
        this.output = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.output.on('line', line => {
            let frame;
            try {
                frame = JSON.parse(line);
            }
            catch {
                this.failed(new Error('usage ledger worker emitted invalid JSON'));
                return;
            }
            this.callbacks.onResponse(frame);
        });
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8').trim();
            if (text.length > 0)
                this.callbacks.onFailure(`usage ledger worker: ${text.slice(-500)}`);
        });
        child.stdin.on('error', error => { this.failed(error); });
        child.on('error', error => { this.failed(error); });
        child.on('exit', (code, signal) => {
            if (this.child !== child)
                return;
            this.child = undefined;
            this.output?.close();
            this.output = undefined;
            this.resolveExit?.();
            this.resolveExit = undefined;
            if (this.stopping)
                return;
            this.callbacks.onFailure(`usage ledger worker exited (${String(code ?? signal ?? 'unknown')})`);
            this.restarting = true;
            const delay = this.restartDelay;
            this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_DELAY_MS);
            this.restartTimer = setTimeout(() => {
                this.restartTimer = undefined;
                this.spawnWorker();
            }, delay);
        });
        this.restartDelay = RESTART_MIN_DELAY_MS;
        this.write(this.initFrame);
        this.flushPending();
    }
    write(frame) {
        if (frame === undefined || this.child === undefined || (this.stopping && frame.type !== 'stop'))
            return;
        try {
            if (!this.child.stdin.write(encodeWorkerFrame(frame))) {
                this.blocked = true;
                this.child.stdin.once('drain', () => {
                    this.blocked = false;
                    this.flushPending();
                });
            }
        }
        catch (error) {
            this.failed(error);
        }
    }
    flushPending() {
        if (this.blocked || this.child === undefined || this.stopping)
            return;
        const control = this.pendingControl.values().next().value;
        if (control !== undefined) {
            const key = control.type === 'dispose' || control.type === 'rescan' ? control.session.id : control.type;
            this.pendingControl.delete(key);
            this.write(control);
            if (this.blocked)
                return;
        }
        const live = this.pendingLive.values().next().value;
        if (live !== undefined) {
            this.pendingLive.delete(live.session.id);
            this.write(live);
        }
    }
    trimPending(pending) {
        while (pending.size > MAX_PENDING_SESSIONS) {
            const oldest = pending.keys().next().value;
            if (oldest === undefined)
                return;
            pending.delete(oldest);
        }
    }
    failed(error) {
        this.callbacks.onFailure(error instanceof Error ? error.message : String(error));
    }
}
