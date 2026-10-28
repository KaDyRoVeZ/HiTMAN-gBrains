// `with { type: 'file' }` imports of the image fixtures in
// scripts/image-decoders-smoketest.ts resolve to the embedded file's path.
declare module '*.heic' {
  const path: string;
  export default path;
}

declare module '*.avif' {
  const path: string;
  export default path;
}
