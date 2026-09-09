import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], optimizeDeps: { include: ['./shared/yield.cjs'] }, base: './', build: { commonjsOptions: { include: [/node_modules/, /shared\/yield\.cjs$/] } } });
