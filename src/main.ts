import './node-version.js';
// 动态加载：旧版 Node 没有 node:sqlite，静态导入会抢在版本检查之前报出难懂的错误
await import('./run.js');
