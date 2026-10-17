import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({base:'./',plugins:[vue(),{name:'dbx-watch-signal',closeBundle(){console.log('DBX_UI_BUILD_SUCCESS')}}],build:{outDir:'ui',assetsInlineLimit:0,cssCodeSplit:false,rollupOptions:{output:{inlineDynamicImports:true}}},server:{port:5192,strictPort:true}});
