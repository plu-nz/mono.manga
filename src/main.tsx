import { render } from 'solid-js/web';
import App from './app/App';
import '@plunz/storybook/styles.css';
import './style.css';

render(() => <App />, document.getElementById('root')!);
