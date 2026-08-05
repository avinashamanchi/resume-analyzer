const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite's web worker ships its database engine as a local WASM asset.
// Keeping it in Metro's asset set also lets the native-web smoke build exercise
// the same provider composition as iOS without substituting storage.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

module.exports = config;
