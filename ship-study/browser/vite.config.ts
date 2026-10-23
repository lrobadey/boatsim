import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),base:'./',
  server:{host:'127.0.0.1',port:5174,strictPort:true,fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}},
  build:{outDir:'build',target:'es2022',chunkSizeWarningLimit:2000},
});
