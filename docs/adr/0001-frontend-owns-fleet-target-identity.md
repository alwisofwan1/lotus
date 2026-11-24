# Frontend Owns Fleet Target Identity

Lotus stores canonical Fleet Target identity in frontend workspace cell state, while the Rust MCP server treats that state as a cache to validate and execute tools against. This keeps Agent Address allocation aligned with the UI-owned workspace lifecycle and preserves monotonic names across app reloads, while still letting Rust enforce Strict Dispatch constraints before writing to PTYs.
