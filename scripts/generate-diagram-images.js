import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'docs', 'images');
const WITH_IMAGES_DIR = path.join(ROOT, 'docs', 'with-images');

const DIAGRAM_METADATA = {
  'docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md': [
    {
      name: '01-layered-system-architecture.svg',
      title: 'Layered System Architecture',
    },
    {
      name: '02-state-machine-rbac-graph.svg',
      title: 'State Machine Transition Graph with RBAC',
    },
    {
      name: '03-claim-contention-sequence.svg',
      title: 'Claim Contention Sequence Diagram',
    },
    {
      name: '04-atomic-persistence-flowchart.svg',
      title: 'Atomic File Protocol (writeAtomic) Flowchart',
    },
    {
      name: '05-pluggable-storage-backends.svg',
      title: 'Pluggable Storage Backends Resolution Flowchart',
    },
    {
      name: '06-realtime-push-sequence.svg',
      title: 'Real-Time Push & UI Synchronization Flow',
    },
  ],
  'docs/FILE_BY_FILE_EXPLANATION.md': [
    {
      name: '07-codebase-dependency-topology.svg',
      title: 'Codebase Dependency & Architecture Topology',
    },
    {
      name: '08-server-request-pipeline.svg',
      title: 'Server Request Pipeline & Execution Flow',
    },
    {
      name: '09-client-component-hierarchy.svg',
      title: 'Client Component Hierarchy & Data Flow',
    },
  ],
  'docs/USER_AND_OPERATOR_MANUAL.md': [
    {
      name: '10-swarm-lifecycle-flowchart.svg',
      title: 'Autonomous Swarm Execution Flowchart',
    },
    {
      name: '11-dashboard-layout-schematic.svg',
      title: 'Web Dashboard Layout Schematic',
    },
    {
      name: '12-diagnostic-decision-tree.svg',
      title: 'Diagnostic Decision Tree',
    },
  ],
};

async function renderMermaidSvg(mermaidCode) {
  // Compress using pako / zlib deflate to stay well within HTTP URI limits
  const json = JSON.stringify({
    code: mermaidCode.trim(),
    mermaid: { theme: 'default' },
  });
  const deflated = deflateSync(json, { level: 9 });
  const b64 = Buffer.from(deflated).toString('base64url');
  const url = `https://mermaid.ink/svg/pako:${b64}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to render SVG (${res.status}): ${errText.slice(0, 150)}`);
  }
  return res.text();
}

async function main() {
  await mkdir(IMAGES_DIR, { recursive: true });
  await mkdir(WITH_IMAGES_DIR, { recursive: true });

  for (const [relPath, diagrams] of Object.entries(DIAGRAM_METADATA)) {
    const fullPath = path.join(ROOT, relPath);
    console.log(`\nProcessing ${relPath}...`);
    const content = await readFile(fullPath, 'utf8');

    const regex = /```mermaid([\s\S]*?)```/g;
    let matchIndex = 0;
    let newContent = '';
    let lastIndex = 0;

    let match;
    while ((match = regex.exec(content)) !== null) {
      const diagramMeta = diagrams[matchIndex];
      if (!diagramMeta) {
        console.warn(`Warning: More diagrams found in ${relPath} than metadata entries.`);
        break;
      }

      const mermaidCode = match[1];
      const svgPath = path.join(IMAGES_DIR, diagramMeta.name);

      console.log(`  Rendering [${matchIndex + 1}/${diagrams.length}] ${diagramMeta.name} ...`);
      try {
        const svgContent = await renderMermaidSvg(mermaidCode);
        await writeFile(svgPath, svgContent, 'utf8');
        console.log(`    ✓ Saved ${diagramMeta.name} (${svgContent.length} bytes)`);
      } catch (err) {
        console.error(`    ✗ Error rendering ${diagramMeta.name}: ${err.message}`);
        throw err;
      }

      // Build replacement with image embed and collapsible source
      const beforeMatch = content.slice(lastIndex, match.index);
      const replacement = `![${diagramMeta.title}](../images/${diagramMeta.name})\n\n<details>\n<summary>View Mermaid Source Code</summary>\n\n\`\`\`mermaid${mermaidCode}\`\`\`\n</details>`;

      newContent += beforeMatch + replacement;
      lastIndex = match.index + match[0].length;
      matchIndex++;
    }

    newContent += content.slice(lastIndex);

    // Save the copy with images into docs/with-images/
    const targetCopyPath = path.join(WITH_IMAGES_DIR, path.basename(relPath));
    await writeFile(targetCopyPath, newContent, 'utf8');
    console.log(`✓ Generated document copy: ${path.relative(ROOT, targetCopyPath)}`);
  }

  console.log('\nAll 12 diagrams rendered and documents generated successfully!');
}

main().catch((err) => {
  console.error('\nFatal error generating diagram images:', err);
  process.exit(1);
});
