// The site's interactive parts, built on Base UI and styled in styles.css.

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Field } from '@base-ui/react/field'
import { Menu } from '@base-ui/react/menu'
import { Switch } from '@base-ui/react/switch'
import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export const TooltipProvider = Tooltip.Provider

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="dialog">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          {description && <Dialog.Description className="dialog-description">{description}</Dialog.Description>}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const ModalClose = Dialog.Close

// A confirmation for something that can't be undone.
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirm,
  danger,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  children?: ReactNode
  confirm: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="backdrop" />
        <AlertDialog.Popup className="dialog">
          <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-description">{description}</AlertDialog.Description>
          {children}
          <div className="dialog-actions">
            <AlertDialog.Close className="ghost">Cancel</AlertDialog.Close>
            <button className={danger ? 'danger-solid' : 'primary'} disabled={busy} onClick={onConfirm}>
              {confirm}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export function TextField({
  label,
  description,
  error,
  ...input
}: { label: string; description?: ReactNode; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field.Root className="field" invalid={!!error}>
      <Field.Label className="field-label">{label}</Field.Label>
      <Field.Control className="field-control" {...(input as object)} />
      {description && <Field.Description className="field-description">{description}</Field.Description>}
      {error && <Field.Error className="field-error" match>{error}</Field.Error>}
    </Field.Root>
  )
}

export function Toggle({
  checked,
  onCheckedChange,
  label,
  description,
  icon,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  description?: ReactNode
  icon?: ReactNode
}) {
  return (
    <Field.Root className="toggle-field">
      <Field.Label className="toggle-label">
        <span className="toggle-text">
          <span className="toggle-title">
            {icon}
            {label}
          </span>
          {description && <span className="field-description">{description}</span>}
        </span>
        <Switch.Root className="switch" checked={checked} onCheckedChange={onCheckedChange}>
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </Field.Label>
    </Field.Root>
  )
}

export function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} aria-label={label} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export type MenuEntry = { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void } | 'separator'

export function ActionMenu({ trigger, items }: { trigger: ReactElement; items: MenuEntry[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="menu">
            {items.map((item, i) =>
              item === 'separator' ? (
                <Menu.Separator key={i} className="menu-separator" />
              ) : (
                <Menu.Item key={item.label} className={`menu-item ${item.danger ? 'danger' : ''}`} onClick={item.onSelect}>
                  {item.icon}
                  {item.label}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
