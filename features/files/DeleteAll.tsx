/** Emptying the list, pinned so a long season does not bury it. */
import { AlertDialog } from '@base-ui-components/react/alert-dialog';

/**
 * Clearing wipes a whole browsing session's captures, and nothing in the
 * extension brings them back -- the episodes have to be walked again. That
 * earns a confirmation rather than a bare button.
 */
export function DeleteAll({ count, onConfirm }: { count: number; onConfirm: () => void }) {
  return (
    <AlertDialog.Root>
      <div className="sticky bottom-0 border-t border-neutral-300 bg-neutral-100 px-[14px] py-[10px]">
        <AlertDialog.Trigger className="btn btn-danger-quiet w-full cursor-pointer py-[6px] text-[12.5px]">
          Delete all {count} files
        </AlertDialog.Trigger>
      </div>

      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Popup className="dialog outline-none">
          <AlertDialog.Title className="dialog-title">Delete the list?</AlertDialog.Title>
          <AlertDialog.Description className="dialog-body">
            {count} captured {count > 1 ? 'files' : 'file'} will be dropped. Nothing
            already downloaded is touched, but recovering the list means playing
            those episodes again.
          </AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Close className="btn btn-secondary cursor-pointer text-[13px]">
              Keep them
            </AlertDialog.Close>
            <AlertDialog.Close
              className="btn btn-danger cursor-pointer text-[13px]"
              onClick={onConfirm}
            >
              Delete all
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
