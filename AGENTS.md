In extensions, use `ctx.cwd` for project paths and new local processes. Do not use `process.cwd()`. Pi does not change `process.cwd()` when a session switches to another project.
