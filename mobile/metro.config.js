const { getDefaultConfig } = require('expo/metro-config');
const { disableTypes } = require('image-size');

// image-size has no patched release for GHSA-w3rx-r6r6-pgpr or
// GHSA-5p2g-fcmc-qvqq. Metro never needs these formats for this app.
disableTypes(['heif', 'icns', 'jxl', 'jxl-stream']);

const config = getDefaultConfig(__dirname);

// expo-sqlite's web worker ships its database engine as a local WASM asset.
// Keeping it in Metro's asset set also lets the native-web smoke build exercise
// the same provider composition as iOS without substituting storage.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

module.exports = config;
