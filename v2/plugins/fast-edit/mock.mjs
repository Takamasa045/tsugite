import live from './index.mjs';
import fixture from './fixture-renderer.mjs';
export default {...live,runtime:undefined,render:fixture.render};
