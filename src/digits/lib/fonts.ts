/**
 * Stubbed font map for the vendored Digits app.
 *
 * The original used `next/font/local`, which does not exist outside Next.js.
 * Fonts are provided globally by the host app (No-touch loads its own fonts in
 * index.html), so every entry resolves to an empty className and the CSS
 * variable `--font-*` is inherited from the host theme.
 */
export const inter = { className: '' };

export const FONT_CLASS_MAP: Record<string, string> = {
  Inter: '',
  Roboto: '',
  Poppins: '',
  'DM Sans': '',
  Lato: '',
  Nunito: '',
  'Open Sans': '',
  Montserrat: '',
  Raleway: '',
  'Source Sans 3': '',
};