import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'lib-dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/library.ts',
      formats: ['es'],
      fileName: 'lamlong-chart',
      cssFileName: 'lamlong-chart',
    },
    rollupOptions: {
      external: ['lucide'],
    },
  },
});
