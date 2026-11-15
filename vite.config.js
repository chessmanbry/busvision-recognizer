import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // 允許外部裝置 (手機) 連線
    proxy: { '/transit-api': { target: 'https://tcgbusfs.blob.core.windows.net', changeOrigin: true, rewrite: p => p.replace(/^\/transit-api/, '') } },
    port: 5173,      // 固定埠號
  },
  build: {
    outDir: 'dist', // 確保輸出目錄正確
  }
})