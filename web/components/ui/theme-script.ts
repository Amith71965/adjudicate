/** Shared by the server layout (inline <head> script) and the client toggle. */
export const THEME_KEY = "adjudicate-theme";

export const themeScript =
  `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});` +
  `if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
