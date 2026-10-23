// Which build this screen is running, shown small and dim in the main
// app's lower right corner (main.js), so a screen still holding yesterday's
// code from a cache can be told at a glance, and at the right of the
// drawer's PRESETS line (ui/screens/drawer.js). Up by .01 with each change
// that ships: v1.00, v1.01, v1.02, ... always two places, never a date or a
// letter.
export const BUILD = 'v1.15';
