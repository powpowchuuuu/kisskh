/** The row's overflow menu, positioned by the primitive rather than by hand. */
import { Menu } from '@base-ui-components/react/menu';

export function MenuPopup({ children }: { children: React.ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Positioner side="bottom" align="end" sideOffset={4}>
        <Menu.Popup className="elev-lg flex min-w-[196px] flex-col rounded-md bg-neutral-100 p-1 outline-none">
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Menu.Item
      onClick={onClick}
      className="cursor-pointer rounded-sm px-[9px] py-[6px] text-left font-body text-[12.5px] text-ink outline-none hover:bg-ink/8 data-highlighted:bg-ink/8"
    >
      {children}
    </Menu.Item>
  );
}
