// The name of a sheet of a KiCad schematic, as the menu of a design
// (KicadView.jsx) and the comment rail (feedview.js) give it.

/** A sheet as a menu and the comment rail name it: its file's name, without
 *  the directory and `.kicad_sch`. */
export const sheetName = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.kicad_sch$/, '');
