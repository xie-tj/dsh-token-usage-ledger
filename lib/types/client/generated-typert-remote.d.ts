import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { UsageLedgerSnapshot, UsageLedgerSnapshotRequest } from '../host/types.js';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespace$75736167654c6564676572506c7567696e {
        snapshot: (request?: UsageLedgerSnapshotRequest) => Promise<RemoteResult<UsageLedgerSnapshot>>;
    }
    interface TypertRemoteMap {
        'usageLedgerPlugin/snapshot': (request?: UsageLedgerSnapshotRequest) => Promise<RemoteResult<UsageLedgerSnapshot>>;
    }
    interface TypertRemoteNamespaceMap {
        'usageLedgerPlugin': TypertRemoteNamespace$75736167654c6564676572506c7567696e;
    }
}
export declare const TYPERT_REMOTE: TypertRemoteContribution;
export default TYPERT_REMOTE;
