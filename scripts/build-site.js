// Builds a static version of the browser workflow into site/ (for GitHub Pages).
// The ledger runs in the visitor's browser (public/ledger.js), so no server is needed.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "site");
const artifact = require("../artifacts/contracts/TokenizedBond.sol/TokenizedBond.json");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "vendor"), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(out, to));
copy("public/project.css", "project.css");
copy("public/bond.js", "bond.js");
copy("public/ledger.js", "ledger.js");
copy("node_modules/ganache/dist/web/ganache.min.js", "vendor/ganache.min.js");
copy("node_modules/ethers/dist/ethers.umd.min.js", "vendor/ethers.umd.min.js");
fs.writeFileSync(
  path.join(out, "bond-artifact.js"),
  `window.BOND_ARTIFACT = ${JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode })};\n`
);

const html = fs.readFileSync(path.join(root, "public/bond.html"), "utf8")
  .replace("Runs against the contract on a local EVM ledger in this server.", "Runs against the contract on a local EVM ledger in this browser.")
  .replace(
    '<script src="bond.js"></script>',
    ['vendor/ganache.min.js', 'vendor/ethers.umd.min.js', 'bond-artifact.js', 'ledger.js', 'bond.js']
      .map((src) => `<script src="${src}"></script>`).join("\n    ")
  );
if (!html.includes("ledger.js") || !html.includes("in this browser")) throw new Error("public/bond.html changed; update scripts/build-site.js.");
fs.writeFileSync(path.join(out, "index.html"), html);
fs.writeFileSync(path.join(out, ".nojekyll"), "");

console.log(`Static site written to ${path.relative(root, out)}/`);
