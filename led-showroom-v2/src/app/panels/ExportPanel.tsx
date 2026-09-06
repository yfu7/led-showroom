/**
 * Export section body: save image, record video, export glTF. The buttons only raise the shared
 * `exportDialog` store flag — the dialogs themselves are mounted once by the TopBar, which outlives
 * this panel (the inspector swaps to an entity as soon as something is selected, and a video take
 * has to survive that: the app stays live while recording).
 *
 * v1 references: 8091-8409 (save image), 8410-8892 (video).
 */
import { Box, Image, Video } from 'lucide-react';
import { Button } from '@/app/components/Button';
import { useStore } from '@/app/store';

export function ExportPanel() {
  const setDialog = useStore(s => s.setExportDialog);
  const icon = (I: typeof Image) => <I size={14} strokeWidth={1.5} />;
  return (
    <>
      <Button block icon={icon(Image)} onClick={() => setDialog('image')}>Save image</Button>
      <Button block icon={icon(Video)} onClick={() => setDialog('video')}>Record video</Button>
      <Button block icon={icon(Box)} onClick={() => setDialog('gltf')}>Export glTF</Button>
      <div className="hint">Exports include the venue backdrop and are cropped to the objects when no photo is set. A video take keeps recording while you orbit, drag and edit the scene.</div>
    </>
  );
}
