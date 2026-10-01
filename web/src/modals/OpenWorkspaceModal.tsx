import { Modal } from "../components/Modal";
import { WorkspacePicker } from "../views/WelcomeView";

export function OpenWorkspaceModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Open a workspace" subtitle="Folders the Yamlet server can see. In the container, that's what you mounted at /workspace." onClose={onClose} width={820}>
      <WorkspacePicker onDone={onClose} />
    </Modal>
  );
}
