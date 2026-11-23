// The Cmd-J titles of the commands an official Orca runs from the palette. The manifest carries the same titles
// (a test keeps them equal), and the panel names them on the card when a button cannot run its command there.
export const PALETTE = {
  reauth: "Grazr: Re-authenticate a blocked account (this workspace's server)",
  'add-account': "Grazr: Add an account (this workspace's server)",
  'sign-in-organization': "Grazr: Sign in another organization of the active login (this workspace's server)",
  'open-browser': "Grazr: Open claude.ai as the active account (this workspace's server)",
  swap: "Grazr: Swap to the next account (this workspace's server)",
  refresh: "Grazr: Refresh usage (this workspace's server)",
  'rotation-toggle': "Grazr: Turn rotation on/off (this workspace's server)",
  'panel-refresh': 'Grazr: Reload panel',
  'limit-reset-model': "Grazr: Use a model limit reset on claude.ai (active account of this workspace's server)",
  'limit-reset-full': "Grazr: Use a full limit reset on claude.ai (active account of this workspace's server)",
}
