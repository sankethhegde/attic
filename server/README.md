# server/ — the HP server (Phase 1C)

Empty until Phase 1C. This is where the server that runs on the HP laptop will live: users, privacy rules, file storage, and later devices and transfers.

Planned stack, from the requirements: Node.js with Express and WebSocket, SQLite for users, devices, the file index and transfers, and a Windows service so the server starts before anyone signs in.

The contract is already fixed: every function in `ui/js/api.js` becomes an endpoint that returns the same JSON shapes the mock returns today. Two rules carry over from Phase 1A:

- Every read goes through one scoped accessor, `visibleIndex(session)`. A missing owner filter must not be possible.
- Ownership changes (revoke, restore, remove, keep permanently) are transactions: all of it or none of it.
