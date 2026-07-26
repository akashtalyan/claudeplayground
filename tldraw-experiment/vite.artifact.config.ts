import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the whole app (JS, CSS, fonts, icons, translations) into one
// self-contained HTML file with no external requests, for publishing
// to sandboxed hosts that block CDNs.
export default defineConfig({
	plugins: [react(), viteSingleFile()],
	build: {
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		outDir: 'dist-artifact',
		chunkSizeWarningLimit: 100_000,
	},
})
