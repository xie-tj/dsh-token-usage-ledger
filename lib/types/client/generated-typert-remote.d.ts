import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { UsageLedgerSnapshot, UsageLedgerSnapshotRequest, UsageLedgerStatus } from '../host/types.js';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespace$75736167654c6564676572506c7567696e {
        snapshot: (request?: UsageLedgerSnapshotRequest) => Promise<RemoteResult<UsageLedgerSnapshot>>;
        status: () => Promise<RemoteResult<UsageLedgerStatus>>;
    }
    interface TypertRemoteMap {
        'usageLedgerPlugin/snapshot': (request?: UsageLedgerSnapshotRequest) => Promise<RemoteResult<UsageLedgerSnapshot>>;
        'usageLedgerPlugin/status': () => Promise<RemoteResult<UsageLedgerStatus>>;
    }
    interface TypertRemoteNamespaceMap {
        'usageLedgerPlugin': TypertRemoteNamespace$75736167654c6564676572506c7567696e;
    }
}
export declare const TYPERT_REMOTE: TypertRemoteContribution;
export default TYPERT_REMOTE;
