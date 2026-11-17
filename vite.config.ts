import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('build');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(isProd
      ? [
          obfuscator({
            include: ['**/src/**/*.ts', '**/src/**/*.tsx'],
            options: {
              compact: true,
              controlFlowFlattening: true,
              controlFlowFlatteningThreshold: 0.5,
              deadCodeInjection: false,
              identifierNamesGenerator: 'mangled-shuffled',
              renameGlobals: false,
              selfDefending: false,
              splitStrings: true,
              splitStringsChunkLength: 8,
              stringArray: true,
              stringArrayEncoding: ['base64'],
              stringArrayThreshold: 0.6,
              transformObjectKeys: false,
              unicodeEscapeSequence: false,
              target: 'browser',
            },
          }),
        ]
      : []),
  ],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    port: 3457,
    host: '127.0.0.1',
  },
  build: {
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
      mangle: { toplevel: true },
      format: { comments: false },
    },
  },
});
