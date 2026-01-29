// Asset type declarations for controls UI

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.jpg" {
  const src: string;
  export default src;
}

declare module "*.jpeg" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.gif" {
  const src: string;
  export default src;
}

// VRM/VRMA asset declarations with Vite URL suffix
declare module "*.vrma?url" {
  const src: string;
  export default src;
}

declare module "*.vrm?url" {
  const src: string;
  export default src;
}
