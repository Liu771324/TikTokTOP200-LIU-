export function matchesCore(text, core) {
  const value = String(text || "").replace(/\s+/g, "");
  if (core === "核桃仁") return value.includes("核桃仁");
  if (core === "脱油花生米") return /脱油.*花生米/.test(value);
  if (core === "冻干桑葚") return /冻干.*桑葚/.test(value);
  return value.includes(core);
}

export function matchingTitleIndexes(titles, core) {
  return titles.reduce((indexes, title, index) => {
    if (matchesCore(title, core)) indexes.push(index);
    return indexes;
  }, []);
}
