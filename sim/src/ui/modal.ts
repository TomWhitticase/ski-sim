/**
 * A modal dialog over the menu: a native `<dialog>` shown with `showModal()`, so it gets
 * a backdrop, keeps focus inside, and closes on Esc. Also closes from its ✕ button
 * (`.modal-close`) or a click on the backdrop.
 */
export class Modal {
  constructor(readonly el: HTMLDialogElement) {
    for (const button of el.querySelectorAll('.modal-close')) {
      button.addEventListener('click', () => this.close());
    }
    // The dialog box is padded by an inner card, so a click on the dialog itself is the backdrop.
    el.addEventListener('click', (e) => {
      if (e.target === el) this.close();
    });
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    if (!this.el.open) this.el.showModal();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }
}
