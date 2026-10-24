/**
 * A dialog opened over another menu (a confirm over the pause menu, Options over the
 * title or the map) gets `stacked`: a nearly solid panel and a darker backdrop, so its
 * text isn't read through the text of the menu behind it.
 */
export function showModalOver(dialog: HTMLDialogElement): void {
  const under = ['#overlay', '#world-map', 'dialog[open]'].some((selector) =>
    [...document.querySelectorAll<HTMLElement>(selector)].some(
      (el) => el !== dialog && el.getClientRects().length > 0,
    ),
  );
  dialog.classList.toggle('stacked', under);
  dialog.showModal();
}
