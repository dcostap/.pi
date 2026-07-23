use async_trait::async_trait;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::io;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

// Six retries over 1.575 seconds. This is long enough for the short-lived
// mappings held by editors, indexers, compilers, and virus scanners without
// noticeably delaying permanent filesystem failures.
const WINDOWS_LOCK_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
];

fn is_transient_windows_file_lock(error: &io::Error) -> bool {
    cfg!(windows)
        && matches!(
            error.raw_os_error(),
            Some(
                32  // ERROR_SHARING_VIOLATION
                    | 33  // ERROR_LOCK_VIOLATION
                    | 36  // ERROR_SHARING_BUFFER_EXCEEDED
                    | 303 // ERROR_DELETE_PENDING
                    | 1224 // ERROR_USER_MAPPED_FILE
            )
        )
}

fn retry_io_with_delays<T>(
    mut operation: impl FnMut() -> io::Result<T>,
    should_retry: impl Fn(&io::Error) -> bool,
    delays: &[Duration],
    mut sleep: impl FnMut(Duration),
) -> io::Result<T> {
    let mut retry = 0;
    loop {
        match operation() {
            Err(error) if retry < delays.len() && should_retry(&error) => {
                sleep(delays[retry]);
                retry += 1;
            }
            result => return result,
        }
    }
}

fn retry_transient_windows_io<T>(operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    retry_io_with_delays(
        operation,
        is_transient_windows_file_lock,
        &WINDOWS_LOCK_RETRY_DELAYS,
        std::thread::sleep,
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreateDirectoryOptions {
    pub recursive: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoveOptions {
    pub recursive: bool,
    pub force: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyOptions {
    pub recursive: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileMetadata {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadDirectoryEntry {
    pub file_name: String,
    pub is_directory: bool,
    pub is_file: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileSystemSandboxContext;

#[async_trait]
pub trait ExecutorFileSystem: Send + Sync {
    async fn read_file(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<Vec<u8>>;

    async fn read_file_text(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<String> {
        let bytes = self.read_file(path, sandbox).await?;
        String::from_utf8(bytes).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
    }

    async fn write_file(&self, path: &AbsolutePathBuf, contents: Vec<u8>, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>;
    async fn create_directory(&self, path: &AbsolutePathBuf, options: CreateDirectoryOptions, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>;
    async fn get_metadata(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<FileMetadata>;
    async fn read_directory(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<Vec<ReadDirectoryEntry>>;
    async fn remove(&self, path: &AbsolutePathBuf, options: RemoveOptions, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>;
    async fn copy(&self, source_path: &AbsolutePathBuf, destination_path: &AbsolutePathBuf, options: CopyOptions, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()>;
}

pub static LOCAL_FS: LazyLock<Arc<dyn ExecutorFileSystem>> = LazyLock::new(|| Arc::new(LocalFileSystem));

struct LocalFileSystem;

fn reject_sandbox(sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()> {
    if sandbox.is_some() {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "sandboxed filesystem is not available in bundled apply_patch"));
    }
    Ok(())
}

fn metadata_to_file_metadata(metadata: std::fs::Metadata) -> FileMetadata {
    FileMetadata {
        is_directory: metadata.is_dir(),
        is_file: metadata.is_file(),
        is_symlink: metadata.file_type().is_symlink(),
        created_at_ms: metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
        modified_at_ms: metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
    }
}

#[async_trait]
impl ExecutorFileSystem for LocalFileSystem {
    async fn read_file(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<Vec<u8>> {
        reject_sandbox(sandbox)?;
        retry_transient_windows_io(|| std::fs::read(path.as_path()))
    }

    async fn write_file(&self, path: &AbsolutePathBuf, contents: Vec<u8>, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()> {
        reject_sandbox(sandbox)?;
        retry_transient_windows_io(|| std::fs::write(path.as_path(), &contents))
    }

    async fn create_directory(&self, path: &AbsolutePathBuf, options: CreateDirectoryOptions, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()> {
        reject_sandbox(sandbox)?;
        retry_transient_windows_io(|| {
            if options.recursive {
                std::fs::create_dir_all(path.as_path())
            } else {
                std::fs::create_dir(path.as_path())
            }
        })
    }

    async fn get_metadata(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<FileMetadata> {
        reject_sandbox(sandbox)?;
        retry_transient_windows_io(|| {
            std::fs::symlink_metadata(path.as_path()).map(metadata_to_file_metadata)
        })
    }

    async fn read_directory(&self, path: &AbsolutePathBuf, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<Vec<ReadDirectoryEntry>> {
        reject_sandbox(sandbox)?;
        retry_transient_windows_io(|| {
            std::fs::read_dir(path.as_path())?
                .map(|entry| {
                    let entry = entry?;
                    let metadata = entry.metadata()?;
                    Ok(ReadDirectoryEntry {
                        file_name: entry.file_name().to_string_lossy().into_owned(),
                        is_directory: metadata.is_dir(),
                        is_file: metadata.is_file(),
                    })
                })
                .collect()
        })
    }

    async fn remove(&self, path: &AbsolutePathBuf, options: RemoveOptions, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()> {
        reject_sandbox(sandbox)?;
        retry_transient_windows_io(|| {
            let metadata = std::fs::symlink_metadata(path.as_path())?;
            if metadata.is_dir() {
                if options.recursive {
                    std::fs::remove_dir_all(path.as_path())
                } else {
                    std::fs::remove_dir(path.as_path())
                }
            } else {
                match std::fs::remove_file(path.as_path()) {
                    Ok(()) => Ok(()),
                    Err(err) if options.force && err.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(err) => Err(err),
                }
            }
        })
    }

    async fn copy(&self, source_path: &AbsolutePathBuf, destination_path: &AbsolutePathBuf, options: CopyOptions, sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()> {
        reject_sandbox(sandbox)?;
        if options.recursive {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "recursive copy is not implemented in bundled apply_patch"));
        }
        retry_transient_windows_io(|| {
            std::fs::copy(source_path.as_path(), destination_path.as_path()).map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn retries_until_operation_succeeds() {
        let attempts = Cell::new(0);
        let slept = RefCell::new(Vec::new());
        let delays = [
            Duration::from_millis(1),
            Duration::from_millis(2),
            Duration::from_millis(4),
        ];

        let result = retry_io_with_delays(
            || {
                let attempt = attempts.get() + 1;
                attempts.set(attempt);
                if attempt < 3 {
                    Err(io::Error::other("locked"))
                } else {
                    Ok("done")
                }
            },
            |_| true,
            &delays,
            |delay| slept.borrow_mut().push(delay),
        );

        assert_eq!(result.unwrap(), "done");
        assert_eq!(attempts.get(), 3);
        assert_eq!(*slept.borrow(), delays[..2]);
    }

    #[test]
    fn returns_last_error_after_retry_limit() {
        let attempts = Cell::new(0);
        let slept = RefCell::new(Vec::new());
        let delays = [Duration::from_millis(1), Duration::from_millis(2)];

        let error = retry_io_with_delays::<()>(
            || {
                let attempt = attempts.get() + 1;
                attempts.set(attempt);
                Err(io::Error::other(format!("locked {attempt}")))
            },
            |_| true,
            &delays,
            |delay| slept.borrow_mut().push(delay),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "locked 3");
        assert_eq!(attempts.get(), 3);
        assert_eq!(*slept.borrow(), delays);
    }

    #[test]
    fn does_not_retry_non_transient_errors() {
        let attempts = Cell::new(0);
        let slept = Cell::new(false);

        let error = retry_io_with_delays::<()>(
            || {
                attempts.set(attempts.get() + 1);
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            },
            |_| false,
            &WINDOWS_LOCK_RETRY_DELAYS,
            |_| slept.set(true),
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(attempts.get(), 1);
        assert!(!slept.get());
    }

    #[test]
    fn recognizes_only_supported_windows_lock_codes_on_windows() {
        for code in [32, 33, 36, 303, 1224] {
            assert_eq!(
                is_transient_windows_file_lock(&io::Error::from_raw_os_error(code)),
                cfg!(windows),
                "unexpected classification for OS error {code}"
            );
        }
        assert!(!is_transient_windows_file_lock(
            &io::Error::from_raw_os_error(5)
        ));
        assert!(!is_transient_windows_file_lock(
            &io::Error::from_raw_os_error(2)
        ));
    }
}
