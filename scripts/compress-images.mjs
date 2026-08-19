import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifestName = '.tinypng-processed.txt';
const manifestPath = path.join(root, manifestName);
const imageDirectories = ['blogs', 'images'];
const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ignoredDirectories = new Set(['.git', '.tmp', 'node_modules']);
const apiKey = process.env.TINIFY_API_KEY;
const minSizeKb = readMinSizeKb(process.argv.slice(2));
const minSizeBytes = minSizeKb * 1024;
const authorization = apiKey ? `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` : '';

function readMinSizeKb(args) {
	const value = args.find(argument => argument.startsWith('--min-size-kb='))?.split('=')[1] ?? '100';
	const size = Number(value);
	if (!Number.isFinite(size) || size < 0) {
		throw new Error(`Invalid --min-size-kb value: ${value}`);
	}
	return size;
}

function toRelativePath(file) {
	return path.relative(root, file).split(path.sep).join('/');
}

async function collectImages(directory, files) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				await collectImages(path.join(directory, entry.name), files);
			}
			continue;
		}

		const file = path.join(directory, entry.name);
		if (entry.isFile() && supportedExtensions.has(path.extname(file).toLowerCase())) {
			files.push(file);
		}
	}
	return files;
}

async function findImages() {
	const files = [];
	for (const directoryName of imageDirectories) {
		const directory = path.join(root, directoryName);
		try {
			if ((await stat(directory)).isDirectory()) await collectImages(directory, files);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	return files;
}

async function hashFile(file) {
	const content = await readFile(file);
	return createHash('sha256').update(content).digest('hex');
}

async function loadManifest() {
	try {
		const content = await readFile(manifestPath, 'utf8');
		const records = new Map();
		for (const line of content.split(/\r?\n/)) {
			if (!line || line.startsWith('#')) continue;
			const [file, hash, bytes, status] = line.split('\t');
			if (file && hash && bytes && status) records.set(file, { hash, status });
		}
		return records;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		await writeFile(
			manifestPath,
			'# TinyPNG processing manifest. One line per final file version.\n# path<TAB>sha256<TAB>bytes<TAB>status<TAB>processed_at\n',
		);
		return new Map();
	}
}

async function record(manifest, file, hash, bytes, status) {
	const relativePath = toRelativePath(file);
	await appendFile(manifestPath, `${relativePath}\t${hash}\t${bytes}\t${status}\t${new Date().toISOString()}\n`);
	manifest.set(relativePath, { hash, status });
}

async function wait(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url, options) {
	let lastError;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let response;
		try {
			response = await fetch(url, options);
		} catch (error) {
			lastError = error;
			await wait(1000 * 2 ** attempt);
			continue;
		}

		if (response.ok) return response;
		const message = await response.text();
		if (response.status !== 429 && response.status < 500) {
			throw new Error(`TinyPNG request failed (${response.status}): ${message}`);
		}
		lastError = new Error(`TinyPNG temporary failure (${response.status}): ${message}`);
		await wait(1000 * 2 ** attempt);
	}
	throw lastError;
}

async function compress(file) {
	if (!apiKey) throw new Error('TINIFY_API_KEY is required to compress an unprocessed image.');

	const input = await readFile(file);
	const shrink = await fetchWithRetry('https://api.tinify.com/shrink', {
		method: 'POST',
		headers: {
			Authorization: authorization,
			'Content-Type': 'application/octet-stream',
		},
		body: input,
	});
	const { output } = await shrink.json();
	if (!output?.url) throw new Error('TinyPNG did not return an output URL.');

	const outputResponse = await fetchWithRetry(output.url, { headers: { Authorization: authorization } });
	const compressed = Buffer.from(await outputResponse.arrayBuffer());
	const temporaryPath = `${file}.tinypng.tmp`;
	await writeFile(temporaryPath, compressed);

	if (compressed.length < input.length) {
		await rename(temporaryPath, file);
		return { bytes: compressed.length, status: 'compressed' };
	}

	await unlink(temporaryPath);
	return { bytes: input.length, status: 'unchanged' };
}

async function main() {
	const manifest = await loadManifest();
	const images = await findImages();
	const summary = { scanned: images.length, skipped: 0, compressed: 0, unchanged: 0, before: 0, after: 0 };

	for (const file of images.sort()) {
		const relativePath = toRelativePath(file);
		const bytes = (await stat(file)).size;
		const hash = await hashFile(file);
		const known = manifest.get(relativePath);

		if (known?.hash === hash && known.status !== 'skipped-size') {
			summary.skipped += 1;
			continue;
		}

		if (bytes < minSizeBytes) {
			if (known?.hash !== hash || known.status !== 'skipped-size') {
				await record(manifest, file, hash, bytes, 'skipped-size');
			}
			summary.skipped += 1;
			continue;
		}

		console.log(`Compressing ${relativePath}`);
		const result = await compress(file);
		const finalHash = result.status === 'compressed' ? await hashFile(file) : hash;
		await record(manifest, file, finalHash, result.bytes, result.status);
		summary.before += bytes;
		summary.after += result.bytes;
		summary[result.status] += 1;
	}

	const saved = summary.before - summary.after;
	const message = [
		`Scanned: ${summary.scanned}`,
		`Already recorded or skipped: ${summary.skipped}`,
		`Compressed: ${summary.compressed}`,
		`No smaller output: ${summary.unchanged}`,
		`Saved: ${(saved / 1024).toFixed(1)} KB`,
	].join('\n');
	console.log(`\n${message}`);
	if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## TinyPNG\n\n${message.replaceAll('\n', '  \n')}\n`);
}

await main();
