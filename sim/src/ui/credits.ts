import type { Provenance } from '../resort/manifest';

const LAYERS: Record<string, string> = {
  'terrain.near': 'Terrain',
  'terrain.far': 'Distant terrain',
  features: 'Lifts, pistes, buildings, peaks',
  landCover: 'Forests, rock, glaciers, lakes',
};

/** Options → Data & credits: every dataset the resort was built from, with its licence. */
export function showCredits(body: HTMLElement, all: Provenance[]): void {
  // One entry per dataset (Copernicus may be both near and far terrain).
  const sources = [...new Map(all.map((p) => [p.name, p])).values()];
  body.replaceChildren(
    ...sources.map((p) => {
      const row = document.createElement('div');
      row.className = 'credit';
      row.innerHTML =
        '<span class="lab"></span><a target="_blank" rel="noopener"></a>' +
        '<p class="credit-attribution"></p><p class="credit-licence"></p>';
      const layers = all.filter((q) => q.name === p.name).map((q) => LAYERS[q.layer] ?? q.layer);
      row.querySelector('.lab')!.textContent = layers.join(' · ');
      const link = row.querySelector('a')!;
      link.href = p.url;
      link.textContent = p.name;
      row.querySelector('.credit-attribution')!.textContent = p.attribution;
      row.querySelector('.credit-licence')!.textContent = p.license;
      return row;
    }),
  );
}
