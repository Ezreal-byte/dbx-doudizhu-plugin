import {createApp} from 'vue';
import App from './App.vue';
import './style.css';
import {installFont} from './game/assets';
void installFont();
createApp(App).mount('#app');
