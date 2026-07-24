import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { downloadFile, resolveLocalTransferPath, resolveRemoteTransferPath, uploadFile } from "./file-transfer.ts";

describe("SSH file transfer paths", () => {
	test("resolves relative local and remote paths against their respective working directories", () => {
		expect(resolveLocalTransferPath("dist/app.jar", "C:/work/project").replaceAll("\\", "/"))
			.toBe("C:/work/project/dist/app.jar");
		expect(resolveRemoteTransferPath("stage/app.jar", "/srv/app"))
			.toBe("/srv/app/stage/app.jar");
	});

	test("keeps absolute remote paths and normalizes leading attachment markers", () => {
		expect(resolveRemoteTransferPath("@/tmp/app.jar", "/srv/app"))
			.toBe("/tmp/app.jar");
	});

	test("rejects empty paths and invalid remote working directories", () => {
		expect(() => resolveLocalTransferPath("", "C:/work")).toThrow("local_path");
		expect(() => resolveRemoteTransferPath("file", "relative")).toThrow("absolute POSIX");
	});
});

describe("SSH file transfers", () => {
	test("streams uploads and downloads through the authenticated SFTP client", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ssh-transfer-"));
		try {
			const localSource = join(root, "source.txt");
			const localDownload = join(root, "downloads", "result.txt");
			const remoteRoot = join(root, "remote");
			await mkdir(join(remoteRoot, "stage"), { recursive: true });
			await writeFile(localSource, "hello over sftp\n", "utf8");
			const client = fakeSftpClient(remoteRoot);

			const uploaded = await uploadFile({
				client,
				localPath: localSource,
				remotePath: "/stage/app.txt",
				overwrite: false,
			});
			expect(await readFile(join(remoteRoot, "stage", "app.txt"), "utf8")).toBe("hello over sftp\n");
			expect(uploaded.bytes).toBe(16);
			expect(uploaded.sha256).toHaveLength(64);

			const downloaded = await downloadFile({
				client,
				localPath: localDownload,
				remotePath: "/stage/app.txt",
				overwrite: false,
			});
			expect(await readFile(localDownload, "utf8")).toBe("hello over sftp\n");
			expect(downloaded.sha256).toBe(uploaded.sha256);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not overwrite a remote destination unless explicitly requested", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ssh-transfer-"));
		try {
			const localSource = join(root, "source.txt");
			const remoteRoot = join(root, "remote");
			await mkdir(join(remoteRoot, "stage"), { recursive: true });
			await writeFile(localSource, "new", "utf8");
			await writeFile(join(remoteRoot, "stage", "app.txt"), "old", "utf8");

			await expect(uploadFile({
				client: fakeSftpClient(remoteRoot),
				localPath: localSource,
				remotePath: "/stage/app.txt",
				overwrite: false,
			})).rejects.toThrow("already exists");
			expect(await readFile(join(remoteRoot, "stage", "app.txt"), "utf8")).toBe("old");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function fakeSftpClient(remoteRoot: string): any {
	const mapPath = (remotePath: string) => join(remoteRoot, ...remotePath.split("/").filter(Boolean));
	const callbackOperation = (operation: () => Promise<unknown>, callback: (error?: Error, value?: any) => void) => {
		void operation().then((value) => callback(undefined, value), (error) => callback(error));
	};
	const sftp = {
		createReadStream: (path: string) => createReadStream(mapPath(path)),
		createWriteStream: (path: string, options: object) => createWriteStream(mapPath(path), options),
		stat: (path: string, callback: (error?: Error, value?: any) => void) => callbackOperation(() => stat(mapPath(path)), callback),
		lstat: (path: string, callback: (error?: Error, value?: any) => void) => callbackOperation(() => lstat(mapPath(path)), callback),
		chmod: (path: string, mode: number, callback: (error?: Error) => void) => callbackOperation(() => chmod(mapPath(path), mode), callback),
		unlink: (path: string, callback: (error?: Error) => void) => callbackOperation(() => unlink(mapPath(path)), callback),
		rename: (source: string, destination: string, callback: (error?: Error) => void) =>
			callbackOperation(() => rename(mapPath(source), mapPath(destination)), callback),
		ext_openssh_rename: (source: string, destination: string, callback: (error?: Error) => void) => callbackOperation(async () => {
			await rm(mapPath(destination), { force: true });
			await rename(mapPath(source), mapPath(destination));
		}, callback),
		end() {},
		destroy() {},
	};
	return { sftp: (callback: (error: Error | undefined, value: any) => void) => callback(undefined, sftp) };
}
