// Shared Chrome extension i18n helpers.
// Chrome selects the locale from the browser language and falls back to the
// manifest's default_locale when a translation is not available.
(() => {
  function interpolate(value, substitutions) {
    if (!value || substitutions == null) return value;
    const args = Array.isArray(substitutions) ? substitutions : [substitutions];
    return value.replace(/\$(\d+)/g, (match, index) => {
      const replacement = args[Number(index) - 1];
      return replacement == null ? match : String(replacement);
    });
  }

  function getMessage(key, substitutions, fallback) {
    let message = "";
    const normalizedSubstitutions = Array.isArray(substitutions)
      ? substitutions.map((value) => String(value))
      : substitutions == null ? substitutions : String(substitutions);
    try {
      if (globalThis.chrome?.i18n?.getMessage) {
        message = globalThis.chrome.i18n.getMessage(
          key,
          normalizedSubstitutions == null ? undefined : normalizedSubstitutions
        );
      }
    } catch { /* Keep the English fallback for non-extension contexts. */ }
    return message || interpolate(fallback == null ? key : fallback, substitutions);
  }

  function localize(root = document) {
    if (!root?.querySelectorAll) return;
    const elements = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches("[data-i18n]")) elements.push(root);
    elements.push(...root.querySelectorAll("[data-i18n]"));
    for (const element of elements) {
      const key = element.getAttribute("data-i18n");
      if (key) element.textContent = getMessage(key);
    }

    const attributes = ["title", "placeholder", "aria-label", "alt"];
    for (const attribute of attributes) {
      const selector = `[data-i18n-${attribute}]`;
      const attrElements = [];
      if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) attrElements.push(root);
      attrElements.push(...root.querySelectorAll(selector));
      for (const element of attrElements) {
        const key = element.getAttribute(`data-i18n-${attribute}`);
        if (key) element.setAttribute(attribute, getMessage(key));
      }
    }
    if (root.documentElement) {
      root.documentElement.lang = getMessage("localeHtmlLang", undefined, "en");
    }
  }

  globalThis.XQF_t = getMessage;
  globalThis.XQF_localize = localize;
})();
