import { Component, useState, mount, useRef, reactive, useEnv, useEffect } from "@odoo/owl";

const ENTER_KEY = 13;
const ESC_KEY = 27;

function useAutofocus(name) {
    let ref = useRef(name);
    useEffect(el => el && el.focus(), () => [ref.el]);
}

function useStore() {
    const env = useEnv();
    return useState(env.store);
}

class TaskList {
    constructor(tasks) {
        this.tasks = tasks || [];
        const taskIds = this.tasks.map((t) => t.id);
        this.nextId = taskIds.length ? Math.max(...taskIds) + 1 : 1;
    }

    addTask(text) {
        text = text.trim();
        if (text) {
            const task = {
                id: this.nextId++,
                text: text,
                isCompleted: false,
            };
            this.tasks.push(task);
        }
    }

    toggleTask(id) {
        const task = this.tasks.find(t => t.id === id);
        task.isCompleted = !task.isCompleted;
    }

    toggleAll(value) {
        for (let task of this.tasks) {
            task.isCompleted = value;
        }
    }
    
    clearCompleted() {
        const tasks = this.tasks.filter(t => t.isCompleted);
        for (let task of tasks) {
            this.deleteTask(task.id);
        }
    }
    
    deleteTask(id) {
        const index = this.tasks.findIndex((t) => t.id === id);
        this.tasks.splice(index, 1);
    }
    
    updateTask(id, text) {
        const value = text.trim();
        if (!value) {
            this.deleteTask(id);
        } else {
            const task = this.tasks.find(t => t.id === id);
            task.text = value;
        }
    }
}

function createTaskStore() {
    const saveTasks = () => localStorage.setItem("todoapp", JSON.stringify(taskStore.tasks));
    const initialTasks = JSON.parse(localStorage.getItem("todoapp") || "[]");
    const taskStore = reactive(new TaskList(initialTasks), saveTasks);
    saveTasks();
    return taskStore;
}
  
class Todo extends Component {
    static template = "Todo";
    
    setup() {
        useAutofocus("input");
        this.store = useStore();
        this.state = useState({
            isEditing: false
        });
    }

    handleKeyup(ev) {
        if (ev.keyCode === ENTER_KEY) {
            this.updateText(ev.target.value);
        }
        if (ev.keyCode === ESC_KEY) {
            ev.target.value = this.props.text;
            this.state.isEditing = false;
        }
    }

    handleBlur(ev) {
        this.updateText(ev.target.value);
    }

    updateText(text) {
        this.store.updateTask(this.props.id, text);
        this.state.isEditing = false;
    }
}

class TodoList extends Component {
    static template = "TodoList";
    static components = { Todo };
    
    setup() {
        this.store = useStore();
        this.state = useState({ filter: "all" });
    }

    get displayedTasks() {
      const tasks = this.store.tasks;
      switch (this.state.filter) {
        case "active":
          return tasks.filter((t) => !t.isCompleted);
        case "completed":
          return tasks.filter((t) => t.isCompleted);
        case "all":
          return tasks;
      }
    }
    
    get allChecked() {
        return this.store.tasks.every(todo => todo.isCompleted);
    }

    get remaining() {
        return this.store.tasks.filter(todo => !todo.isCompleted).length;
    }

    get remainingText() {
        const items = this.remaining < 2 ? "item" : "items";
        return ` ${items} left`;
    }

    addTodo(ev) {
        if (ev.keyCode === ENTER_KEY) {
            const text = ev.target.value;
            if (text.trim()) {
                this.store.addTask(text);
            }
            ev.target.value = "";
        }
    }

    setFilter(filter) {
        this.state.filter = filter;
    }
}

const env = { store: createTaskStore() };
mount(TodoList, document.body, { env, templates: TEMPLATES, dev: true });
