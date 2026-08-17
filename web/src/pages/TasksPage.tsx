import { useNavigate } from "react-router-dom";
import { TaskManager } from "@/components/TaskManager.tsx";
import { PageHeader } from "@/components/page-header.tsx";
import { useI18n } from "@/i18n/index.tsx";

export function TasksPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader title={t("Task Manager")} description={t("Tasks Description")} />
      <TaskManager
        onRestoreParams={(params) => navigate("/", { state: { restoreParams: params } })}
      />
    </div>
  );
}
