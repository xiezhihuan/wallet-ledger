const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`需要 Node.js 22.13 或更高（推荐 24 LTS），当前是 ${process.version}。使用 nvm 时可在项目目录执行：nvm install && nvm use`);
  process.exit(1);
}
export {};
