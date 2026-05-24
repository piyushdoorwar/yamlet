using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Markup.Xaml;
using Avalonia.Media;
using Avalonia;
using Yamlet.App.ViewModels;

namespace Yamlet.App.Views;

public partial class MainWindow : Window
{
    private static readonly DataFormat<TreeNodeViewModel> TreeNodeFormat =
        DataFormat.CreateInProcessFormat<TreeNodeViewModel>("yamlet-tree-node");

    private Point _dragStart;
    private TreeNodeViewModel? _dragNode;
    private PointerPressedEventArgs? _dragStartArgs;

    public MainWindow()
    {
        AvaloniaXamlLoader.Load(this);

        var tree = this.FindControl<TreeView>("CollectionsTree");
        if (tree is null)
        {
            return;
        }

        tree.AddHandler(PointerPressedEvent, OnTreePointerPressed, handledEventsToo: true);
        tree.AddHandler(PointerMovedEvent, OnTreePointerMoved, handledEventsToo: true);
        tree.AddHandler(DragDrop.DragOverEvent, OnTreeDragOver);
        tree.AddHandler(DragDrop.DropEvent, OnTreeDrop);
    }

    private void OnTreePointerPressed(object? sender, PointerPressedEventArgs e)
    {
        _dragNode = FindNode(e.Source as StyledElement);
        _dragStartArgs = e;
        _dragStart = e.GetPosition(this);
    }

    private async void OnTreePointerMoved(object? sender, PointerEventArgs e)
    {
        if (_dragNode is null || _dragStartArgs is null || !e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            return;
        }

        var current = e.GetPosition(this);
        if (Math.Abs(current.X - _dragStart.X) < 4 && Math.Abs(current.Y - _dragStart.Y) < 4)
        {
            return;
        }

        var node = _dragNode;
        _dragNode = null;
        var data = new DataTransfer();
        data.Add(DataTransferItem.Create(TreeNodeFormat, node));
        await DragDrop.DoDragDropAsync(_dragStartArgs, data, DragDropEffects.Move);
        _dragStartArgs = null;
    }

    private void OnTreeDragOver(object? sender, DragEventArgs e)
    {
        if (e.DataTransfer.TryGetValue(TreeNodeFormat) is not TreeNodeViewModel source ||
            FindNode(e.Source as StyledElement) is not { } target ||
            !CanDrop(source, target))
        {
            e.DragEffects = DragDropEffects.None;
            return;
        }

        e.DragEffects = DragDropEffects.Move;
    }

    private async void OnTreeDrop(object? sender, DragEventArgs e)
    {
        if (DataContext is not MainWindowViewModel vm ||
            e.DataTransfer.TryGetValue(TreeNodeFormat) is not TreeNodeViewModel source ||
            FindNode(e.Source as StyledElement) is not { } target ||
            !CanDrop(source, target))
        {
            return;
        }

        await vm.MoveTreeNodeAsync(source, target);
    }

    private static TreeNodeViewModel? FindNode(StyledElement? element)
    {
        while (element is not null)
        {
            if (element.DataContext is TreeNodeViewModel node)
            {
                return node;
            }

            element = element.Parent as StyledElement;
        }

        return null;
    }

    private static bool CanDrop(TreeNodeViewModel source, TreeNodeViewModel target)
    {
        if (ReferenceEquals(source, target))
        {
            return false;
        }

        if (source is CollectionNodeViewModel)
        {
            return false;
        }

        if (source is FolderNodeViewModel && IsDescendantOf(target, source))
        {
            return false;
        }

        return target is CollectionNodeViewModel or FolderNodeViewModel or RequestNodeViewModel;
    }

    private static bool IsDescendantOf(TreeNodeViewModel node, TreeNodeViewModel possibleAncestor)
    {
        var current = node.Parent;
        while (current is not null)
        {
            if (ReferenceEquals(current, possibleAncestor))
            {
                return true;
            }

            current = current.Parent;
        }

        return false;
    }
}
