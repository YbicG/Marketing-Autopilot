// Remotion's bundler resolves font imports to asset URLs (asset/resource).
declare module "*.woff2" {
  const url: string;
  export default url;
}
