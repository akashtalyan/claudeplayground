import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2022', assetsInlineLimit: Infinity },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173, strictPort: false },
})
