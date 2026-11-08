// Nethely / cPanel (Phusion Passenger) belépési pont: ezt kell "Application startup file"-nak megadni.
// A port a process.env.PORT változóból jön (Passenger állítja be), helyi futtatásnál 4000.
require('dotenv').config();
require('./server').start(Number(process.env.PORT || 4000));
