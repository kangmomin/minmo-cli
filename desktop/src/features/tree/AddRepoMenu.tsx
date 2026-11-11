import { FolderOpenIcon, FolderPlusIcon, FolderGit2Icon, PlusIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import { AddGitHubRepoDialog, NewProjectDialog, OpenFolderDialog } from './AddRepoDialogs'

type Which = 'new' | 'open' | 'github'

/** 사이드바 "+" — 새 프로젝트 · 폴더 열기 · GitHub 저장소 추가 */
export function AddRepoMenu() {
  const [open, setOpen] = useState<Which | null>(null)
  const props = (which: Which) => ({ open: open === which, onOpenChange: (o: boolean) => setOpen(o ? which : null) })
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="저장소 추가" title="저장소 추가(새 프로젝트·폴더 열기)">
            <PlusIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen('new')}>
            <FolderPlusIcon /> 새 프로젝트…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen('open')}>
            <FolderOpenIcon /> 폴더 열기…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen('github')}>
            <FolderGit2Icon /> GitHub 저장소 추가…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewProjectDialog {...props('new')} />
      <OpenFolderDialog {...props('open')} />
      <AddGitHubRepoDialog {...props('github')} />
    </>
  )
}
