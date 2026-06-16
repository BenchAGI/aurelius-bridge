import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function loadTranspiledTsModule(relativePath, { mocks = {} } = {}) {
  const filename = path.join(appRoot, relativePath);
  const source = await readFile(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const module = { exports: {} };
  const realRequire = createRequire(filename);
  const requireForTest = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    return realRequire(specifier);
  };

  const context = {
    Buffer,
    clearTimeout,
    console,
    exports: module.exports,
    global,
    module,
    process,
    require: requireForTest,
    setTimeout,
    TextDecoder,
    TextEncoder,
    URL,
    __dirname: path.dirname(filename),
    __filename: filename,
  };

  vm.runInNewContext(output, context, { filename });
  return module.exports;
}
