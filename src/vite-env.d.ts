/// <reference types="vite/client" />
// Brings in Vite's ambient module declarations — notably `*.module.css`, which
// types a CSS-module import as a readonly class-name map. Without this every
// `import s from './X.module.css'` is a TS2307.
