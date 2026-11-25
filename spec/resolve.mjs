// The mod's modules import each other as './x.js', as TypeScript and Claude Code's validator want; here Node runs the .ts sources.
import { registerHooks } from 'node:module';

registerHooks({
  resolve: (specifier, context, next) => next(context.parentURL?.endsWith('.ts') && specifier.startsWith('.') ? specifier.replace(/\.js$/, '.ts') : specifier, context),
});
