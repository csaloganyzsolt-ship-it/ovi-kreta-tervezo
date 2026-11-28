// Az Adminból szerkeszthető űrlapszövegek és opciólisták (GET /api/config → planner_config) alkalmazása a tervezőn.
// Csak textContent / .value / .placeholder kerül a DOM-ba (nincs HTML-értelmezés), így az admin által megadott szöveg nem lehet XSS-forrás.
// A statikus HTML az alapérték: hibás /api/config esetén is működik az űrlap a beépített szövegekkel.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

const PLANNER_DEFAULT_IDS = { group: 'nagycsoport', energyLevel: 'atlagos' };

// Az Adminban átírt szövegek (kulcs → szöveg); az összegző kártya feliratai ebből jönnek, a beépített szöveg a tartalék.
let plannerTexts = {};
function plannerText(key, fallback) {
  const value = plannerTexts[key];
  return typeof value === 'string' && value ? value : fallback;
}

function plannerOptionContainer(list) {
  return document.querySelector(`[data-cfg-options="${list}"]`);
}

function plannerOptionElements(list) {
  const container = plannerOptionContainer(list);
  return container ? Array.from(container.querySelectorAll('[data-option-id]')) : [];
}

// Az alapértelmezett opció felirata: a megadott alap-azonosítójú, különben az első aktív elem.
function plannerDefaultLabel(list) {
  const options = plannerOptionElements(list);
  const wanted = PLANNER_DEFAULT_IDS[list];
  const match = options.find((option) => option.dataset.optionId === wanted) || options[0];
  return match ? (match.dataset.value || match.value || match.dataset.sniLabel || match.dataset.iktTool || match.textContent.trim()) : '';
}

function renderPlannerSelect(select, items) {
  const previousId = select.selectedOptions[0]?.dataset.optionId;
  const previousValue = select.value;
  const fallbackId = PLANNER_DEFAULT_IDS[select.dataset.cfgOptions];
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement('option');
    option.value = item.label;
    option.textContent = item.label;
    option.dataset.optionId = item.id;
    return option;
  }));
  const keep = items.find((item) => item.id === previousId) || items.find((item) => item.label === previousValue) || items.find((item) => item.id === fallbackId) || items[0];
  select.value = keep.label;
}

function renderPlannerEnergy(container, items) {
  const previousId = container.querySelector('.segment.active')?.dataset.optionId;
  container.replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segment';
    button.dataset.group = 'energy';
    button.dataset.optionId = item.id;
    button.dataset.value = item.label;
    button.textContent = item.label;
    return button;
  }));
  const keep = items.find((item) => item.id === previousId) || items.find((item) => item.id === PLANNER_DEFAULT_IDS.energyLevel) || items[0];
  container.querySelector(`[data-option-id="${keep.id}"]`).classList.add('active');
  ENERGY_DEFAULT = (items.find((item) => item.id === PLANNER_DEFAULT_IDS.energyLevel) || items[0]).label;
}

function renderPlannerSni(container, items) {
  const checked = new Set(Array.from(container.querySelectorAll('input:checked')).map((input) => input.dataset.optionId));
  container.replaceChildren(...items.map((item) => {
    const label = document.createElement('label');
    label.className = 'check-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.optionId = item.id;
    input.dataset.sniLabel = item.label;
    input.checked = checked.has(item.id);
    const text = document.createElement('span');
    text.textContent = item.label;
    label.append(input, ' ', text);
    return label;
  }));
}

function renderPlannerIkt(container, items) {
  const active = new Set(Array.from(container.querySelectorAll('.active')).map((button) => button.dataset.optionId));
  container.replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = active.has(item.id) ? 'chip active' : 'chip';
    button.dataset.optionId = item.id;
    button.dataset.iktTool = item.label;
    button.textContent = item.label;
    return button;
  }));
}

function applyPlannerConfig(config) {
  if (!config || typeof config !== 'object') return;
  const texts = config.texts && typeof config.texts === 'object' ? config.texts : {};
  plannerTexts = texts;
  document.querySelectorAll('[data-cfg-text]').forEach((node) => {
    const value = texts[node.dataset.cfgText];
    if (typeof value === 'string' && value) node.textContent = value;
  });
  document.querySelectorAll('[data-cfg-placeholder]').forEach((node) => {
    const value = texts[node.dataset.cfgPlaceholder];
    if (typeof value === 'string' && value) node.placeholder = value;
  });
  const lists = config.optionLists && typeof config.optionLists === 'object' ? config.optionLists : {};
  const valid = (items) => Array.isArray(items) && items.length > 0 && items.every((item) => item && typeof item.id === 'string' && typeof item.label === 'string' && item.label);
  const renderers = {
    group: renderPlannerSelect,
    tevekenysegForma: renderPlannerSelect,
    fridayClosingType: renderPlannerSelect,
    energyLevel: renderPlannerEnergy,
    specialNeeds: renderPlannerSni,
    iktTools: renderPlannerIkt
  };
  Object.entries(renderers).forEach(([list, render]) => {
    const container = plannerOptionContainer(list);
    if (container && valid(lists[list])) render(container, lists[list]);
  });
  updateSummary();
}

// Delegált eseménykezelők: az újrarenderelt opciók is működnek. A kijelölés mentése a meglévő piszkozat-logikával történik.
function plannerSelectionChanged() {
  updateSummary();
  saveProfileToStorage();
  persistDraftState();
}

document.addEventListener('click', (event) => {
  const segment = event.target.closest('.segment[data-group="energy"]');
  if (segment) {
    setChoice('energy', segment.dataset.value);
    plannerSelectionChanged();
    return;
  }
  const chip = event.target.closest('#iktToolsPicker [data-ikt-tool]');
  if (chip) {
    chip.classList.toggle('active');
    updateSummary();
    persistDraftState();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-sni-label]')) plannerSelectionChanged();
});
