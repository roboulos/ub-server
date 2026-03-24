import { createServer } from 'hp-base';
import ts from 'typescript';

const compile = (code: string): string =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: false,
    },
  }).outputText;

const { start } = createServer({
  name: 'backend-dashboard-api',
  tsCompiler: compile,
});

start();
