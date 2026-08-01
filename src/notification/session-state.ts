/** Sub-agent session tracking shared by notification hooks. */
export const subagentSessions = new Set<string>();
export const syncSubagentSessions = new Set<string>();

let _mainSessionID: string | undefined;

export function setMainSession(id: string | undefined): void {
  _mainSessionID = id;
}

export function getMainSessionID(): string | undefined {
  return _mainSessionID;
}

export function _resetForTesting(): void {
  _mainSessionID = undefined;
  subagentSessions.clear();
  syncSubagentSessions.clear();
}
