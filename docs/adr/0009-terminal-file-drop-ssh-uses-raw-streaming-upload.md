# Terminal File Drop SSH uploads use raw streaming jobs

SSH-backed Terminal File Drop uploads use cancellable raw binary streams over `ssh -T`, with the remote side atomically choosing a collision-safe destination and moving a completed temp file into place. We chose this over `scp` because destination naming and cancellation need to be owned by Lotus, and over `editor_write_file_ssh` because that path is text-oriented, base64-expanded, capped for editor files, and not suitable for arbitrary binary drops.

## Consequences

Upload state needs a small job registry so the UI can cancel an in-flight batch. Each file is atomic, but the batch is allowed to partially succeed; prompt insertion happens after the batch settles and includes only successfully uploaded remote paths.
